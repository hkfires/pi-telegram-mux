import { describe, expect, it, vi } from "vitest";
import { BoundedOutbox } from "../src/outbox.js";

describe("outbox scheduling", () => {
  it("reserves queued capacity immediately and yields beyond microtasks", async () => {
    const work = vi.fn(async () => {});
    const box = new BoundedOutbox(vi.fn());
    box.enqueue(work, 10);
    expect(box.size).toBe(1);
    let idle = false;
    const drained = box.whenIdle().then(() => { idle = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(work).not.toHaveBeenCalled();
    expect(idle).toBe(false);
    await drained;
    expect(work).toHaveBeenCalledOnce();
    expect(box.size).toBe(0);
  });

  it("cancels a scheduled job and retains FIFO for replacement jobs", async () => {
    const order: number[] = [];
    const box = new BoundedOutbox(vi.fn());
    box.enqueue(async () => { order.push(0); });
    box.reset();
    box.enqueue(async () => { order.push(1); });
    box.enqueue(async () => { order.push(2); });
    await box.whenIdle();
    expect(order).toEqual([1, 2]);
  });

  it.each(["jobs", "bytes"])("enforces the %s limit before scheduled work starts", async limit => {
    const failure = vi.fn();
    const work = vi.fn(async () => {});
    const box = new BoundedOutbox(failure, limit === "jobs" ? 1 : 10, 10);
    expect(box.enqueue(work, 10)).toBe(true);
    expect(box.enqueue(work, 1)).toBe(false);
    await box.whenIdle();
    expect(work).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledOnce();
    box.reset();
    expect(box.enqueue(work, 10)).toBe(true);
    await box.whenIdle();
    expect(work).toHaveBeenCalledOnce();
  });
});
