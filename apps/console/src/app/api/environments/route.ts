import { forward, queryOf } from '../proxy';

export async function GET(request: Request) {
  return forward(`/v1/environments${queryOf(request, ['tenantId'])}`);
}
