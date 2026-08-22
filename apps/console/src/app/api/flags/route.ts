import { forward, queryOf } from '../proxy';

export async function GET(request: Request) {
  return forward(`/v1/flags${queryOf(request, ['tenantId', 'environmentId'])}`);
}

export async function POST(request: Request) {
  return forward('/v1/flags', { method: 'POST', body: await request.json() });
}
