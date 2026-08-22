import { forward } from '../proxy';

export async function GET() {
  return forward('/v1/tenants');
}
