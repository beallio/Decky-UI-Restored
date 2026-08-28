export class FeatureController {
  private disposer: (() => void) | undefined;
  private disposed = false;

  constructor(
    private readonly installer: () => () => void,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  get enabled(): boolean {
    return this.disposer !== undefined;
  }

  setEnabled(enabled: boolean): boolean {
    if (this.disposed) return !enabled;
    if (enabled === this.enabled) return true;
    if (enabled) {
      try {
        this.disposer = this.installer();
        return true;
      } catch (error) {
        this.onError(error);
        this.disposer = undefined;
        return false;
      }
    }

    const dispose = this.disposer;
    this.disposer = undefined;
    try {
      dispose?.();
      return true;
    } catch (error) {
      this.onError(error);
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    try {
      this.setEnabled(false);
    } finally {
      this.disposed = true;
    }
  }
}
