import { forward, queryOf } from '../../proxy';

export async function GET(
  request: Request,
  context: { params: Promise<{ key: string }> },
) {
  const { key } = await context.params;
  return forward(
    `/v1/flags/${encodeURIComponent(key)}${queryOf(request, ['tenantId', 'environmentId'])}`,
  );
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ key: string }> },
) {
  const { key } = await context.params;
  return forward(`/v1/flags/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    body: await request.json(),
  });
}
