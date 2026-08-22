import { FlagList } from '@/components/FlagList';

export default function FlagsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Feature flags</h1>
        <p className="text-sm text-muted">
          Configuration is stored per environment and reaches SDKs on publish.
        </p>
      </div>
      <FlagList />
    </div>
  );
}
