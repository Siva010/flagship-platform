import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// React Testing Library does not unmount between tests on its own when globals
// are enabled, so a component from one test can still be in the document during
// the next and make queries ambiguous.
afterEach(cleanup);
