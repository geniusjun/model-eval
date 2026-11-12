import { Component, type ReactNode } from 'react';

import type { Lang } from '../../../src/config/schema.js';
import { InvalidReport } from './InvalidReport.js';

interface RootErrorBoundaryProps {
  readonly lang: Lang;
  readonly children: ReactNode;
}

interface RootErrorBoundaryState {
  readonly failed: boolean;
}

/** Shows the error screen when a region throws while rendering, instead of a blank page. */
export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  override state: RootErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? (
      <InvalidReport problem={{ kind: 'render' }} lang={this.props.lang} />
    ) : (
      this.props.children
    );
  }
}
