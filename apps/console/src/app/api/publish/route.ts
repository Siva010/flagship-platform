import { forward } from '../proxy';

export async function POST(request: Request) {
  return forward('/v1/publish', { method: 'POST', body: await request.json() });
}
