import { AuditLog } from '@/components/AuditLog';

export default function AuditPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-muted">
          Append-only. Every entry records the previous value, not just the new one.
        </p>
      </div>
      <AuditLog />
    </div>
  );
}
