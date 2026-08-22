import { PayloadPlayground } from '@/components/PayloadPlayground';

export default function PlaygroundPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Payload playground</h1>
        <p className="text-sm text-muted">
          Edit a rule tree and watch the server and client payloads diverge. Filtering
          behaviour is the easiest thing here to get wrong, and the failure is invisible.
        </p>
      </div>
      <PayloadPlayground />
    </div>
  );
}
