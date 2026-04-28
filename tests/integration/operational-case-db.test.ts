import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  addCaseComment,
  addCaseEvent,
  addCaseTask,
  completeCaseTask,
  createOperationCase,
  decideCaseDecision,
  linkCaseObject,
  loadCaseDetail,
  requestCaseDecision,
} from "../../app/lib/operational-case.server";
import {
  importShopifyOrder,
  type TenantContext,
} from "../../app/lib/operational-core.server";

const connectionString = process.env.OPERATIONS_LEDGER_DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;
const testShopDomain = "phase5-case-test.myshopify.com";

let pool: pg.Pool;
let ctx: TenantContext;

async function deleteTestTenant() {
  await pool.query(
    "delete from public.tenants where primary_shop_domain = $1",
    [testShopDomain],
  );
}

async function createTestTenant() {
  const result = await pool.query<{ id: string }>(
    `
      insert into public.tenants (primary_shop_domain, status, plan_code)
      values ($1, 'ACTIVE', 'DEV')
      returning id
    `,
    [testShopDomain],
  );

  ctx = { tenantId: result.rows[0]!.id, shopDomain: testShopDomain };
}

describeIfDatabase("operational case foundation against local Supabase", () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString });
  });

  beforeEach(async () => {
    await deleteTestTenant();
    await createTestTenant();
  });

  afterAll(async () => {
    await deleteTestTenant();
    await pool.end();
  });

  it("creates cases with tasks, comments, decisions, links and idempotent events", async () => {
    const firstCase = await createOperationCase(pool, ctx, {
      caseType: "inventory_discrepancy",
      priority: "high",
      summary: "Investigate inventory count",
      idempotencyKey: "case-test:inventory-discrepancy",
    });
    const repeatedCase = await createOperationCase(pool, ctx, {
      caseType: "inventory_discrepancy",
      priority: "high",
      summary: "Investigate inventory count",
      idempotencyKey: "case-test:inventory-discrepancy",
    });
    const task = await addCaseTask(pool, ctx, {
      operationCaseId: firstCase.operationCaseId,
      title: "Count shelf A",
    });
    const completedTask = await completeCaseTask(pool, ctx, task.caseTaskId);
    const decision = await requestCaseDecision(pool, ctx, {
      operationCaseId: firstCase.operationCaseId,
      decisionType: "resolve_discrepancy",
      reason: "Approve adjustment path.",
    });
    const decided = await decideCaseDecision(pool, ctx, {
      caseDecisionId: decision.caseDecisionId,
      status: "approved",
      decisionValue: "adjust_stock",
    });
    const comment = await addCaseComment(pool, ctx, {
      operationCaseId: firstCase.operationCaseId,
      body: "Physical count completed.",
    });
    const link = await linkCaseObject(pool, ctx, {
      operationCaseId: firstCase.operationCaseId,
      linkedObjectType: "shopify_variant",
      linkedObjectId: "gid://shopify/ProductVariant/case-test",
      linkedObjectGid: "gid://shopify/ProductVariant/case-test",
      relationType: "affected_variant",
    });
    const event = await addCaseEvent(pool, ctx, {
      operationCaseId: firstCase.operationCaseId,
      eventType: "COUNT_VERIFIED",
      title: "Count verified",
      idempotencyKey: "case-test:count-verified",
    });
    const repeatedEvent = await addCaseEvent(pool, ctx, {
      operationCaseId: firstCase.operationCaseId,
      eventType: "COUNT_VERIFIED",
      title: "Count verified",
      idempotencyKey: "case-test:count-verified",
    });
    const detail = await loadCaseDetail(pool, ctx, firstCase.operationCaseId);

    expect(firstCase.alreadyCreated).toBe(false);
    expect(repeatedCase).toMatchObject({
      operationCaseId: firstCase.operationCaseId,
      alreadyCreated: true,
    });
    expect(completedTask).toMatchObject({ status: "done" });
    expect(decided).toMatchObject({ status: "approved" });
    expect(comment.caseCommentId).toBeTruthy();
    expect(link.caseLinkId).toBeTruthy();
    expect(event.alreadyRecorded).toBe(false);
    expect(repeatedEvent).toMatchObject({
      caseEventId: event.caseEventId,
      alreadyRecorded: true,
    });
    expect(detail.tasks).toContainEqual(
      expect.objectContaining({ id: task.caseTaskId, status: "done" }),
    );
    expect(detail.decisions).toContainEqual(
      expect.objectContaining({ id: decision.caseDecisionId, status: "approved" }),
    );
    expect(detail.comments).toContainEqual(
      expect.objectContaining({ body: "Physical count completed." }),
    );
    expect(detail.links).toContainEqual(
      expect.objectContaining({ relationType: "affected_variant" }),
    );
    expect(detail.events).toContainEqual(
      expect.objectContaining({ eventType: "COUNT_VERIFIED" }),
    );
  });

  it("links imported Operations Orders to an Operation Case", async () => {
    const imported = await importShopifyOrder(pool, {
      shopDomain: testShopDomain,
      shopifyOrderId: "gid://shopify/Order/case-linked",
      shopifyOrderName: "#CASE-1",
      lines: [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/case-linked",
          sku: "CASE-LINKED",
          title: "Case Linked Item",
          quantity: 1,
        },
      ],
    });
    const orderResult = await pool.query<{ operation_case_id: string | null }>(
      `
        select operation_case_id
        from public.operations_orders
        where tenant_id = $1
          and id = $2
      `,
      [ctx.tenantId, imported.operationsOrderId],
    );
    const caseEvents = await pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from public.case_events
        where tenant_id = $1
          and operation_case_id = $2
      `,
      [ctx.tenantId, orderResult.rows[0]?.operation_case_id],
    );

    expect(imported.operationCaseId).toBeTruthy();
    expect(orderResult.rows[0]?.operation_case_id).toBe(imported.operationCaseId);
    expect(caseEvents.rows[0]?.count).not.toBe("0");
  });
});
