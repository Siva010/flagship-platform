import { FlagDetailView } from '@/components/FlagDetailView';

export default async function FlagPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <FlagDetailView flagKey={decodeURIComponent(key)} />;
}
