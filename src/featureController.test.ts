import { describe, expect, it, vi } from "vitest";
import { FeatureController } from "./featureController";

describe("FeatureController", () => {
  it("installs once, disables once, and supports re-enable", () => {
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const installer = vi
      .fn<() => () => void>()
      .mockReturnValueOnce(firstDispose)
      .mockReturnValueOnce(secondDispose);
    const controller = new FeatureController(installer);

    expect(controller.setEnabled(true)).toBe(true);
    expect(controller.setEnabled(true)).toBe(true);
    expect(installer).toHaveBeenCalledOnce();
    expect(controller.setEnabled(false)).toBe(true);
    expect(controller.setEnabled(false)).toBe(true);
    expect(firstDispose).toHaveBeenCalledOnce();
    controller.setEnabled(true);
    controller.dispose();
    expect(installer).toHaveBeenCalledTimes(2);
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it("fails closed when installation or disposal throws", () => {
    const onError = vi.fn();
    const controller = new FeatureController(() => {
      throw new Error("install failed");
    }, onError);
    expect(controller.setEnabled(true)).toBe(false);
    expect(controller.enabled).toBe(false);

    const disposing = new FeatureController(
      () => () => {
        throw new Error("dispose failed");
      },
      onError,
    );
    disposing.setEnabled(true);
    expect(disposing.setEnabled(false)).toBe(false);
    expect(disposing.enabled).toBe(false);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("makes disposal terminal so late async work cannot reinstall the patch", () => {
    const disposePatch = vi.fn();
    const installer = vi.fn(() => disposePatch);
    const controller = new FeatureController(installer);

    expect(controller.setEnabled(true)).toBe(true);
    controller.dispose();

    expect(controller.setEnabled(true)).toBe(false);
    expect(controller.enabled).toBe(false);
    expect(installer).toHaveBeenCalledOnce();
    expect(disposePatch).toHaveBeenCalledOnce();
  });
});
