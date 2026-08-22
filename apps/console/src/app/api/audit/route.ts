import { forward, queryOf } from '../proxy';

export async function GET(request: Request) {
  return forward(`/v1/audit${queryOf(request, ['tenantId', 'resourceKey'])}`);
}
