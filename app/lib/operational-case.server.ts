import type { QueryExecutor } from "./foundation-db.server";
import type { TenantContext } from "./operational-core.server";

export type OperationCaseType =
  | "order_clarification"
  | "fulfillment_exception"
  | "refund_approval"
  | "return_case"
  | "inventory_discrepancy"
  | "purchase_need"
  | "general_operations_case";

export type OperationCaseStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "waiting_for_decision"
  | "closed"
  | "cancelled";

export type OperationCasePriority = "low" | "normal" | "high" | "urgent";
export type CaseTaskStatus = "open" | "in_progress" | "done" | "cancelled";
export type CaseDecisionStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "cancelled";

export interface OperationCaseListItem {
  id: string;
  caseType: string;
  status: string;
  priority: string;
  summary: string;
  assignedRoleName: string | null;
  blockedReason: string | null;
  dueAt: string | null;
  openTaskCount: number;
  pendingDecisionCount: number;
  createdAt: string;
}

function toNumber(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

function toIso(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function addCaseEvent(
  db: QueryExecutor,
  ctx: TenantContext,
  input: {
    operationCaseId: string;
    eventType: string;
    title: string;
    message?: string | null;
    actorType?: "system" | "user" | "shopify" | "job";
    actorId?: string | null;
    source?: string;
    sourceRef?: string | null;
    metadata?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
  },
) {
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  const result = await db.query<{ id: string }>(
    `
      insert into public.case_events (
        tenant_id,
        operation_case_id,
        event_type,
        title,
        message,
        actor_type,
        actor_id,
        source,
        source_ref,
        metadata,
        idempotency_key
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
      on conflict (tenant_id, idempotency_key)
      where idempotency_key is not null
      do nothing
      returning id
    `,
    [
      ctx.tenantId,
      input.operationCaseId,
      input.eventType,
      input.title,
      input.message ?? null,
      input.actorType ?? "system",
      input.actorId ?? null,
      input.source ?? "operations_ledger",
      input.sourceRef ?? null,
      JSON.stringify(input.metadata ?? {}),
      idempotencyKey,
    ],
  );
  const inserted = result.rows[0];

  if (inserted) {
    return { caseEventId: inserted.id, alreadyRecorded: false };
  }

  if (!idempotencyKey) {
    throw new Error("Case event was not recorded");
  }

  const existing = await db.query<{ id: string }>(
    `
      select id
      from public.case_events
      where tenant_id = $1
        and idempotency_key = $2
      limit 1
    `,
    [ctx.tenantId, idempotencyKey],
  );

  return {
    caseEventId: existing.rows[0]!.id,
    alreadyRecorded: true,
  };
}

export async function createOperationCase(
  db: QueryExecutor,
  ctx: TenantContext,
  input: {
    caseType: OperationCaseType;
    status?: OperationCaseStatus;
    priority?: OperationCasePriority;
    summary: string;
    description?: string | null;
    shopInstallationId?: string | null;
    ownerUserId?: string | null;
    assignedUserId?: string | null;
    assignedRoleId?: string | null;
    primaryShopifyObjectType?: string | null;
    primaryShopifyObjectId?: string | null;
    primaryShopifyObjectGid?: string | null;
    blockedReason?: string | null;
    dueAt?: string | null;
    idempotencyKey?: string | null;
  },
) {
  if (!input.summary.trim()) {
    throw new Error("Operation case summary is required");
  }

  const idempotencyKey = input.idempotencyKey?.trim() || null;

  if (idempotencyKey) {
    const existing = await db.query<{ id: string; status: string }>(
      `
        select operation_cases.id, operation_cases.status
        from public.idempotency_keys
        join public.operation_cases
          on operation_cases.id = idempotency_keys.result_ref_id
        where idempotency_keys.tenant_id = $1
          and idempotency_keys.key = $2
          and idempotency_keys.purpose = 'OPERATION_CASE_CREATE'
          and idempotency_keys.result_ref_type = 'operation_case'
        limit 1
      `,
      [ctx.tenantId, idempotencyKey],
    );

    if (existing.rows[0]) {
      return {
        operationCaseId: existing.rows[0].id,
        status: existing.rows[0].status,
        alreadyCreated: true,
      };
    }
  }

  const result = await db.query<{ id: string; status: string }>(
    `
      insert into public.operation_cases (
        tenant_id,
        shop_installation_id,
        case_type,
        status,
        priority,
        summary,
        description,
        owner_user_id,
        assigned_user_id,
        assigned_role_id,
        primary_shopify_object_type,
        primary_shopify_object_id,
        primary_shopify_object_gid,
        blocked_reason,
        due_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      returning id, status
    `,
    [
      ctx.tenantId,
      input.shopInstallationId ?? null,
      input.caseType,
      input.status ?? "open",
      input.priority ?? "normal",
      input.summary,
      input.description ?? null,
      input.ownerUserId ?? null,
      input.assignedUserId ?? null,
      input.assignedRoleId ?? null,
      input.primaryShopifyObjectType ?? null,
      input.primaryShopifyObjectId ?? null,
      input.primaryShopifyObjectGid ?? null,
      input.blockedReason ?? null,
      input.dueAt ?? null,
    ],
  );
  const operationCase = result.rows[0]!;

  if (idempotencyKey) {
    await db.query(
      `
        insert into public.idempotency_keys (
          tenant_id,
          key,
          purpose,
          result_ref_type,
          result_ref_id
        )
        values ($1, $2, 'OPERATION_CASE_CREATE', 'operation_case', $3)
        on conflict (tenant_id, key) do nothing
      `,
      [ctx.tenantId, idempotencyKey, operationCase.id],
    );
  }

  await addCaseEvent(db, ctx, {
    operationCaseId: operationCase.id,
    eventType: "CASE_CREATED",
    title: "Case created",
    message: input.summary,
    idempotencyKey: idempotencyKey ? `case_created:${idempotencyKey}` : null,
    metadata: {
      case_type: input.caseType,
      priority: input.priority ?? "normal",
    },
  });

  return {
    operationCaseId: operationCase.id,
    status: operationCase.status,
    alreadyCreated: false,
  };
}

export async function linkCaseObject(
  db: QueryExecutor,
  ctx: TenantContext,
  input: {
    operationCaseId: string;
    linkedObjectType: string;
    linkedObjectId: string;
    linkedObjectGid?: string | null;
    relationType: string;
  },
) {
  const result = await db.query<{ id: string }>(
    `
      insert into public.case_links (
        tenant_id,
        operation_case_id,
        linked_object_type,
        linked_object_id,
        linked_object_gid,
        relation_type
      )
      values ($1, $2, $3, $4, $5, $6)
      on conflict (
        tenant_id,
        operation_case_id,
        linked_object_type,
        linked_object_id,
        relation_type
      )
      do nothing
      returning id
    `,
    [
      ctx.tenantId,
      input.operationCaseId,
      input.linkedObjectType,
      input.linkedObjectId,
      input.linkedObjectGid ?? null,
      input.relationType,
    ],
  );

  if (result.rows[0]) {
    return { caseLinkId: result.rows[0].id, alreadyLinked: false };
  }

  const existing = await db.query<{ id: string }>(
    `
      select id
      from public.case_links
      where tenant_id = $1
        and operation_case_id = $2
        and linked_object_type = $3
        and linked_object_id = $4
        and relation_type = $5
      limit 1
    `,
    [
      ctx.tenantId,
      input.operationCaseId,
      input.linkedObjectType,
      input.linkedObjectId,
      input.relationType,
    ],
  );

  return { caseLinkId: existing.rows[0]!.id, alreadyLinked: true };
}

export async function addCaseComment(
  db: QueryExecutor,
  ctx: TenantContext,
  input: {
    operationCaseId: string;
    body: string;
    authorUserId?: string | null;
    internal?: boolean;
  },
) {
  if (!input.body.trim()) {
    throw new Error("Case comment body is required");
  }

  const result = await db.query<{ id: string }>(
    `
      insert into public.case_comments (
        tenant_id,
        operation_case_id,
        author_user_id,
        body,
        internal
      )
      values ($1, $2, $3, $4, $5)
      returning id
    `,
    [
      ctx.tenantId,
      input.operationCaseId,
      input.authorUserId ?? null,
      input.body,
      input.internal ?? true,
    ],
  );

  await addCaseEvent(db, ctx, {
    operationCaseId: input.operationCaseId,
    eventType: "COMMENT_ADDED",
    title: "Comment added",
    message: input.body,
    actorType: input.authorUserId ? "user" : "system",
    actorId: input.authorUserId ?? null,
    source: "case_comments",
    sourceRef: result.rows[0]!.id,
  });

  return { caseCommentId: result.rows[0]!.id };
}

export async function addCaseTask(
  db: QueryExecutor,
  ctx: TenantContext,
  input: {
    operationCaseId: string;
    title: string;
    description?: string | null;
    assignedUserId?: string | null;
    assignedRoleId?: string | null;
    dueAt?: string | null;
  },
) {
  if (!input.title.trim()) {
    throw new Error("Case task title is required");
  }

  const result = await db.query<{ id: string }>(
    `
      insert into public.case_tasks (
        tenant_id,
        operation_case_id,
        title,
        description,
        status,
        assigned_user_id,
        assigned_role_id,
        due_at
      )
      values ($1, $2, $3, $4, 'open', $5, $6, $7)
      returning id
    `,
    [
      ctx.tenantId,
      input.operationCaseId,
      input.title,
      input.description ?? null,
      input.assignedUserId ?? null,
      input.assignedRoleId ?? null,
      input.dueAt ?? null,
    ],
  );

  await addCaseEvent(db, ctx, {
    operationCaseId: input.operationCaseId,
    eventType: "TASK_ADDED",
    title: "Task added",
    message: input.title,
    source: "case_tasks",
    sourceRef: result.rows[0]!.id,
  });

  return { caseTaskId: result.rows[0]!.id, status: "open" as CaseTaskStatus };
}

export async function completeCaseTask(
  db: QueryExecutor,
  ctx: TenantContext,
  caseTaskId: string,
) {
  const result = await db.query<{
    id: string;
    operation_case_id: string;
    status: string;
  }>(
    `
      update public.case_tasks
      set status = 'done',
          completed_at = coalesce(completed_at, now()),
          updated_at = now()
      where tenant_id = $1
        and id = $2
        and status in ('open', 'in_progress')
      returning id, operation_case_id, status
    `,
    [ctx.tenantId, caseTaskId],
  );
  const task = result.rows[0];

  if (!task) {
    const existing = await db.query<{
      id: string;
      operation_case_id: string;
      status: string;
    }>(
      `
        select id, operation_case_id, status
        from public.case_tasks
        where tenant_id = $1
          and id = $2
        limit 1
      `,
      [ctx.tenantId, caseTaskId],
    );

    if (existing.rows[0]?.status === "done") {
      return { caseTaskId, status: "done" as CaseTaskStatus, alreadyDone: true };
    }

    throw new Error("Open case task not found");
  }

  await addCaseEvent(db, ctx, {
    operationCaseId: task.operation_case_id,
    eventType: "TASK_COMPLETED",
    title: "Task completed",
    source: "case_tasks",
    sourceRef: task.id,
    idempotencyKey: `task_completed:${task.id}`,
  });

  return { caseTaskId: task.id, status: "done" as CaseTaskStatus, alreadyDone: false };
}

export async function requestCaseDecision(
  db: QueryExecutor,
  ctx: TenantContext,
  input: {
    operationCaseId: string;
    decisionType:
      | "approve_refund"
      | "approve_fulfillment"
      | "approve_purchase"
      | "resolve_discrepancy"
      | "close_case";
    requestedByUserId?: string | null;
    reason?: string | null;
  },
) {
  const result = await db.query<{ id: string; status: string }>(
    `
      insert into public.case_decisions (
        tenant_id,
        operation_case_id,
        decision_type,
        status,
        requested_by_user_id,
        reason
      )
      values ($1, $2, $3, 'requested', $4, $5)
      returning id, status
    `,
    [
      ctx.tenantId,
      input.operationCaseId,
      input.decisionType,
      input.requestedByUserId ?? null,
      input.reason ?? null,
    ],
  );

  await db.query(
    `
      update public.operation_cases
      set status = 'waiting_for_decision',
          updated_at = now()
      where tenant_id = $1
        and id = $2
        and status not in ('closed', 'cancelled')
    `,
    [ctx.tenantId, input.operationCaseId],
  );
  await addCaseEvent(db, ctx, {
    operationCaseId: input.operationCaseId,
    eventType: "DECISION_REQUESTED",
    title: "Decision requested",
    message: input.decisionType,
    source: "case_decisions",
    sourceRef: result.rows[0]!.id,
  });

  return { caseDecisionId: result.rows[0]!.id, status: result.rows[0]!.status };
}

export async function decideCaseDecision(
  db: QueryExecutor,
  ctx: TenantContext,
  input: {
    caseDecisionId: string;
    status: "approved" | "rejected" | "cancelled";
    decidedByUserId?: string | null;
    decisionValue?: string | null;
    reason?: string | null;
  },
) {
  const result = await db.query<{
    id: string;
    operation_case_id: string;
    status: string;
  }>(
    `
      update public.case_decisions
      set status = $3,
          decided_by_user_id = $4,
          decision_value = $5,
          reason = $6,
          decided_at = now(),
          updated_at = now()
      where tenant_id = $1
        and id = $2
        and status = 'requested'
      returning id, operation_case_id, status
    `,
    [
      ctx.tenantId,
      input.caseDecisionId,
      input.status,
      input.decidedByUserId ?? null,
      input.decisionValue ?? null,
      input.reason ?? null,
    ],
  );
  const decision = result.rows[0];

  if (!decision) {
    throw new Error("Requested case decision not found");
  }

  await db.query(
    `
      update public.operation_cases
      set status = case
            when status = 'waiting_for_decision' then 'in_progress'
            else status
          end,
          updated_at = now()
      where tenant_id = $1
        and id = $2
    `,
    [ctx.tenantId, decision.operation_case_id],
  );
  await addCaseEvent(db, ctx, {
    operationCaseId: decision.operation_case_id,
    eventType: "DECISION_RECORDED",
    title: `Decision ${input.status}`,
    message: input.reason ?? input.decisionValue ?? null,
    actorType: input.decidedByUserId ? "user" : "system",
    actorId: input.decidedByUserId ?? null,
    source: "case_decisions",
    sourceRef: decision.id,
    idempotencyKey: `decision_recorded:${decision.id}`,
  });

  return { caseDecisionId: decision.id, status: decision.status as CaseDecisionStatus };
}

export async function loadCaseList(
  db: QueryExecutor,
  ctx: TenantContext,
  input: { limit?: number } = {},
): Promise<OperationCaseListItem[]> {
  const result = await db.query<{
    id: string;
    case_type: string;
    status: string;
    priority: string;
    summary: string;
    assigned_role_name: string | null;
    blocked_reason: string | null;
    due_at: Date | null;
    open_task_count: string;
    pending_decision_count: string;
    created_at: Date;
  }>(
    `
      select operation_cases.id,
             operation_cases.case_type,
             operation_cases.status,
             operation_cases.priority,
             operation_cases.summary,
             roles.name as assigned_role_name,
             operation_cases.blocked_reason,
             operation_cases.due_at,
             (
               select count(*)::text
               from public.case_tasks
               where case_tasks.operation_case_id = operation_cases.id
                 and case_tasks.status in ('open', 'in_progress')
             ) as open_task_count,
             (
               select count(*)::text
               from public.case_decisions
               where case_decisions.operation_case_id = operation_cases.id
                 and case_decisions.status = 'requested'
             ) as pending_decision_count,
             operation_cases.created_at
      from public.operation_cases
      left join public.roles
        on roles.id = operation_cases.assigned_role_id
      where operation_cases.tenant_id = $1
      order by case
                 when operation_cases.status in ('open', 'in_progress', 'blocked', 'waiting_for_decision') then 0
                 else 1
               end,
               operation_cases.created_at desc
      limit $2
    `,
    [ctx.tenantId, input.limit ?? 20],
  );

  return result.rows.map((row) => ({
    id: row.id,
    caseType: row.case_type,
    status: row.status,
    priority: row.priority,
    summary: row.summary,
    assignedRoleName: row.assigned_role_name,
    blockedReason: row.blocked_reason,
    dueAt: toIso(row.due_at),
    openTaskCount: toNumber(row.open_task_count),
    pendingDecisionCount: toNumber(row.pending_decision_count),
    createdAt: row.created_at.toISOString(),
  }));
}

export async function loadRecentCaseEvents(
  db: QueryExecutor,
  ctx: TenantContext,
  input: { limit?: number } = {},
) {
  const result = await db.query<{
    id: string;
    operation_case_id: string;
    case_summary: string;
    event_type: string;
    title: string;
    message: string | null;
    created_at: Date;
  }>(
    `
      select case_events.id,
             case_events.operation_case_id,
             operation_cases.summary as case_summary,
             case_events.event_type,
             case_events.title,
             case_events.message,
             case_events.created_at
      from public.case_events
      join public.operation_cases
        on operation_cases.id = case_events.operation_case_id
      where case_events.tenant_id = $1
      order by case_events.created_at desc
      limit $2
    `,
    [ctx.tenantId, input.limit ?? 10],
  );

  return result.rows.map((row) => ({
    id: row.id,
    operationCaseId: row.operation_case_id,
    caseSummary: row.case_summary,
    eventType: row.event_type,
    title: row.title,
    message: row.message,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function loadCaseDetail(
  db: QueryExecutor,
  ctx: TenantContext,
  operationCaseId: string,
) {
  const caseResult = await db.query<{
    id: string;
    case_type: string;
    status: string;
    priority: string;
    summary: string;
    description: string | null;
    assigned_role_name: string | null;
    primary_shopify_object_type: string | null;
    primary_shopify_object_id: string | null;
    primary_shopify_object_gid: string | null;
    blocked_reason: string | null;
    due_at: Date | null;
    created_at: Date;
  }>(
    `
      select operation_cases.*,
             roles.name as assigned_role_name
      from public.operation_cases
      left join public.roles
        on roles.id = operation_cases.assigned_role_id
      where operation_cases.tenant_id = $1
        and operation_cases.id = $2
      limit 1
    `,
    [ctx.tenantId, operationCaseId],
  );
  const operationCase = caseResult.rows[0];

  if (!operationCase) {
    throw new Error("Operation case not found");
  }

  const [tasks, decisions, comments, links, events] = await Promise.all([
    db.query<{ id: string; title: string; status: string; due_at: Date | null }>(
      `
        select id, title, status, due_at
        from public.case_tasks
        where tenant_id = $1
          and operation_case_id = $2
        order by created_at desc
      `,
      [ctx.tenantId, operationCaseId],
    ),
    db.query<{ id: string; decision_type: string; status: string; reason: string | null }>(
      `
        select id, decision_type, status, reason
        from public.case_decisions
        where tenant_id = $1
          and operation_case_id = $2
        order by created_at desc
      `,
      [ctx.tenantId, operationCaseId],
    ),
    db.query<{ id: string; body: string; internal: boolean; created_at: Date }>(
      `
        select id, body, internal, created_at
        from public.case_comments
        where tenant_id = $1
          and operation_case_id = $2
        order by created_at desc
      `,
      [ctx.tenantId, operationCaseId],
    ),
    db.query<{
      id: string;
      linked_object_type: string;
      linked_object_id: string;
      relation_type: string;
    }>(
      `
        select id, linked_object_type, linked_object_id, relation_type
        from public.case_links
        where tenant_id = $1
          and operation_case_id = $2
        order by created_at desc
      `,
      [ctx.tenantId, operationCaseId],
    ),
    db.query<{
      id: string;
      event_type: string;
      title: string;
      message: string | null;
      created_at: Date;
    }>(
      `
        select id, event_type, title, message, created_at
        from public.case_events
        where tenant_id = $1
          and operation_case_id = $2
        order by created_at desc
      `,
      [ctx.tenantId, operationCaseId],
    ),
  ]);

  return {
    case: {
      id: operationCase.id,
      caseType: operationCase.case_type,
      status: operationCase.status,
      priority: operationCase.priority,
      summary: operationCase.summary,
      description: operationCase.description,
      assignedRoleName: operationCase.assigned_role_name,
      primaryShopifyObjectType: operationCase.primary_shopify_object_type,
      primaryShopifyObjectId: operationCase.primary_shopify_object_id,
      primaryShopifyObjectGid: operationCase.primary_shopify_object_gid,
      blockedReason: operationCase.blocked_reason,
      dueAt: toIso(operationCase.due_at),
      createdAt: operationCase.created_at.toISOString(),
    },
    tasks: tasks.rows.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      dueAt: toIso(task.due_at),
    })),
    decisions: decisions.rows.map((decision) => ({
      id: decision.id,
      decisionType: decision.decision_type,
      status: decision.status,
      reason: decision.reason,
    })),
    comments: comments.rows.map((comment) => ({
      id: comment.id,
      body: comment.body,
      internal: comment.internal,
      createdAt: comment.created_at.toISOString(),
    })),
    links: links.rows.map((link) => ({
      id: link.id,
      linkedObjectType: link.linked_object_type,
      linkedObjectId: link.linked_object_id,
      relationType: link.relation_type,
    })),
    events: events.rows.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      title: event.title,
      message: event.message,
      createdAt: event.created_at.toISOString(),
    })),
  };
}

export async function createDemoOperationalCases(
  db: QueryExecutor,
  ctx: TenantContext,
) {
  const orderClarification = await createOperationCase(db, ctx, {
    caseType: "order_clarification",
    status: "waiting_for_decision",
    priority: "normal",
    summary: "Clarify shipping instructions for sample order",
    description: "Customer note needs internal review before work continues.",
    primaryShopifyObjectType: "shopify_order",
    primaryShopifyObjectId: "demo-order-clarification",
    idempotencyKey: "demo:case:order_clarification",
  });
  const fulfillmentException = await createOperationCase(db, ctx, {
    caseType: "fulfillment_exception",
    status: "blocked",
    priority: "high",
    summary: "Blocked fulfillment for address mismatch",
    description: "Warehouse needs an operator to confirm address handling.",
    blockedReason: "Address mismatch requires operational review.",
    primaryShopifyObjectType: "shopify_order",
    primaryShopifyObjectId: "demo-fulfillment-exception",
    idempotencyKey: "demo:case:fulfillment_exception",
  });
  const inventoryDiscrepancy = await createOperationCase(db, ctx, {
    caseType: "inventory_discrepancy",
    status: "open",
    priority: "urgent",
    summary: "Inventory discrepancy for OPS-KIT-DEMO",
    description: "Expected stock does not match physical count.",
    primaryShopifyObjectType: "shopify_variant",
    primaryShopifyObjectId: "OPS-KIT-DEMO",
    idempotencyKey: "demo:case:inventory_discrepancy",
  });

  if (!fulfillmentException.alreadyCreated) {
    await addCaseTask(db, ctx, {
      operationCaseId: fulfillmentException.operationCaseId,
      title: "Confirm corrected delivery address",
    });
  }

  if (!orderClarification.alreadyCreated) {
    await requestCaseDecision(db, ctx, {
      operationCaseId: orderClarification.operationCaseId,
      decisionType: "approve_fulfillment",
      reason: "Confirm whether order can proceed with current note.",
    });
  }

  if (!inventoryDiscrepancy.alreadyCreated) {
    await addCaseComment(db, ctx, {
      operationCaseId: inventoryDiscrepancy.operationCaseId,
      body: "Demo count variance created for Phase 5 case workflow verification.",
    });
  }

  await addCaseEvent(db, ctx, {
    operationCaseId: inventoryDiscrepancy.operationCaseId,
    eventType: "DISCREPANCY_NOTED",
    title: "Inventory discrepancy noted",
    message: "Physical count differs from available inventory.",
    idempotencyKey: "demo:event:inventory_discrepancy_noted",
  });

  return {
    operationCaseIds: [
      orderClarification.operationCaseId,
      fulfillmentException.operationCaseId,
      inventoryDiscrepancy.operationCaseId,
    ],
  };
}
