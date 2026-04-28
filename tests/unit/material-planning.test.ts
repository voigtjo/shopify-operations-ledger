import { describe, expect, it } from "vitest";

import { explodeBomLines } from "../../app/lib/material-planning.server";

describe("material planning helpers", () => {
  it("explodes BOM component quantities from parent demand", () => {
    expect(
      explodeBomLines(3, [
        { componentItemId: "component-a", quantity: 2 },
        { componentItemId: "component-b", quantity: 0.5 },
      ]),
    ).toEqual([
      { componentItemId: "component-a", requiredQuantity: 6 },
      { componentItemId: "component-b", requiredQuantity: 1.5 },
    ]);
  });
});
