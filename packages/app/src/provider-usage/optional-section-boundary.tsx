import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Renders nothing when an optional section of a larger panel fails to render, so the panel
 * around it keeps working. The failure is logged, not shown.
 */
export class OptionalSectionBoundary extends Component<
  { name: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(`[${this.props.name}] Section render failed`, error, info.componentStack);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
