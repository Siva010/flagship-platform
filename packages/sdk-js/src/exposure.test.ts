import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExposureBuffer, type ExposureEvent, type ExposureTransport } from './exposure.ts';

class RecordingTransport implements ExposureTransport {
  readonly batches: ExposureEvent[][] = [];
  failNext = false;
  delayMs = 0;

  async send(events: ExposureEvent[]): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failNext) {
      this.failNext = false;
      throw new Error('transport exploded');
    }
    this.batches.push(events);
  }

  get allEvents(): ExposureEvent[] {
    return this.batches.flat();
  }
}

function event(index: number) {
  return {
    flagKey: `flag-${index}`,
    variationKey: 'on',
    contextKey: `user-${index}`,
    rulesetVersion: 1,
  };
}

describe('ExposureBuffer', () => {
  it('buffers without sending until the batch fills', async () => {
    const transport = new RecordingTransport();
    const buffer = new ExposureBuffer({ transport, batchSize: 5 });

    for (let i = 0; i < 4; i++) buffer.record(event(i));
    assert.equal(transport.batches.length, 0, 'must not send before the batch is full');
    assert.equal(buffer.stats.queued, 4);

    buffer.record(event(4));
    await buffer.flush();
    assert.equal(transport.allEvents.length, 5);
  });

  it('assigns a timestamp and dedupe key', async () => {
    const transport = new RecordingTransport();
    const buffer = new ExposureBuffer({ transport, batchSize: 100 });

    buffer.record(event(1));
    await buffer.flush();

    const sent = transport.allEvents[0]!;
    assert.ok(sent.timestamp, 'timestamp assigned');
    assert.ok(sent.dedupeKey.includes('user-1'), 'dedupe key derived from the event');
  });

  it('gives every event a distinct dedupe key', async () => {
    const transport = new RecordingTransport();
    const buffer = new ExposureBuffer({ transport, batchSize: 1000 });

    // Same flag and context repeatedly: the keys must still differ, or the
    // server would deduplicate genuine repeat exposures into one.
    for (let i = 0; i < 100; i++) buffer.record(event(1));
    await buffer.flush();

    const keys = new Set(transport.allEvents.map((e) => e.dedupeKey));
    assert.equal(keys.size, 100);
  });

  it('drops rather than growing once the queue is full', () => {
    const transport = new RecordingTransport();
    // No sampling, so the hard cap is what is under test.
    const buffer = new ExposureBuffer({
      transport,
      batchSize: 1_000_000,
      maxQueueSize: 10,
      samplingThreshold: 1,
    });

    for (let i = 0; i < 100; i++) buffer.record(event(i));

    assert.equal(buffer.stats.queued, 10, 'queue must not exceed its cap');
    assert.equal(buffer.stats.recorded, 10);
    assert.equal(buffer.stats.dropped, 90);
  });

  it('samples progressively as the queue fills, rather than dropping all at once', () => {
    const transport = new RecordingTransport();
    const buffer = new ExposureBuffer({
      transport,
      batchSize: 1_000_000,
      maxQueueSize: 100,
      samplingThreshold: 0.5,
    });

    // Below the threshold, everything is kept.
    for (let i = 0; i < 50; i++) buffer.record(event(i));
    assert.equal(buffer.stats.recorded, 50);
    assert.equal(buffer.stats.sampled, 0);
    assert.equal(buffer.samplingRate, 1);

    // Past it, the rate decays.
    for (let i = 0; i < 200; i++) buffer.record(event(i));
    assert.ok(buffer.stats.sampled > 0, 'sampling should have kicked in');
    assert.ok(buffer.samplingRate < 1, `rate = ${buffer.samplingRate}, want < 1`);
    assert.ok(buffer.stats.queued <= 100);
  });

  it('never throws from record, even when the transport fails', async () => {
    const transport = new RecordingTransport();
    const errors: Error[] = [];
    const buffer = new ExposureBuffer({
      transport,
      batchSize: 2,
      onError: (error) => errors.push(error),
    });

    transport.failNext = true;
    assert.doesNotThrow(() => {
      buffer.record(event(1));
      buffer.record(event(2));
    });

    await buffer.flush();
    // Give the fire-and-forget flush a turn.
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(errors.length >= 1, 'failure reported through onError');
    assert.ok(buffer.stats.failed >= 1);
  });

  it('does not retry a failed batch in memory', async () => {
    // Retrying would grow the queue during exactly the outage that caused the
    // failure, turning a transport problem into a memory problem.
    const transport = new RecordingTransport();
    const buffer = new ExposureBuffer({ transport, batchSize: 1000, onError: () => {} });

    for (let i = 0; i < 10; i++) buffer.record(event(i));
    transport.failNext = true;
    await buffer.flush();

    assert.equal(buffer.stats.queued, 0, 'failed batch is discarded, not requeued');
    assert.equal(buffer.stats.failed, 10);
  });

  it('survives a throwing error handler', async () => {
    const transport = new RecordingTransport();
    const buffer = new ExposureBuffer({
      transport,
      batchSize: 1000,
      onError: () => {
        throw new Error('handler exploded');
      },
    });

    buffer.record(event(1));
    transport.failNext = true;
    await assert.doesNotReject(() => buffer.flush());
  });

  it('does not run two flushes concurrently', async () => {
    const transport = new RecordingTransport();
    transport.delayMs = 30;
    const buffer = new ExposureBuffer({ transport, batchSize: 1000 });

    for (let i = 0; i < 10; i++) buffer.record(event(i));

    // Two flushes racing would send the same events twice.
    await Promise.all([buffer.flush(), buffer.flush(), buffer.flush()]);
    assert.equal(transport.batches.length, 1);
    assert.equal(transport.allEvents.length, 10);
  });

  it('flushes remaining events on close', async () => {
    const transport = new RecordingTransport();
    const buffer = new ExposureBuffer({ transport, batchSize: 1000 });

    for (let i = 0; i < 3; i++) buffer.record(event(i));
    await buffer.close();

    assert.equal(transport.allEvents.length, 3);
    assert.equal(buffer.record(event(99)), false, 'closed buffer accepts nothing');
  });

  it('is safe to close more than once', async () => {
    const buffer = new ExposureBuffer({ transport: new RecordingTransport() });
    await buffer.close();
    await assert.doesNotReject(() => buffer.close());
  });

  it('flushing an empty queue is a no-op', async () => {
    const transport = new RecordingTransport();
    const buffer = new ExposureBuffer({ transport });
    await buffer.flush();
    assert.equal(transport.batches.length, 0);
  });
});
