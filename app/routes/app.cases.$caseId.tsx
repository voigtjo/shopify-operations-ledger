import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { getFoundationDatabasePool } from "../lib/foundation-db.server";
import { loadCaseDetail } from "../lib/operational-case.server";
import { getTenantContextByShopDomain } from "../lib/operational-core.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const pool = getFoundationDatabasePool();

  if (!pool) {
    throw new Error("Operations Ledger database is not configured");
  }

  if (!params.caseId) {
    throw new Error("Operation case id is required");
  }

  const ctx = await getTenantContextByShopDomain(pool, session.shop);

  return loadCaseDetail(pool, ctx, params.caseId);
};

export default function OperationCaseDetail() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading={data.case.summary}>
      <s-section heading="Case">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text>{data.case.caseType}</s-text>
            <s-text> · {data.case.status}</s-text>
            <s-text> · {data.case.priority}</s-text>
            {data.case.assignedRoleName && (
              <s-text> · {data.case.assignedRoleName}</s-text>
            )}
          </s-paragraph>
          {data.case.description && (
            <s-paragraph>{data.case.description}</s-paragraph>
          )}
          {data.case.primaryShopifyObjectType && (
            <s-paragraph>
              <s-text>Linked Shopify object: </s-text>
              <s-text>{data.case.primaryShopifyObjectType}</s-text>
              <s-text> · {data.case.primaryShopifyObjectId}</s-text>
            </s-paragraph>
          )}
          {data.case.blockedReason && (
            <s-paragraph>
              <s-text>Blocked: </s-text>
              <s-text>{data.case.blockedReason}</s-text>
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Tasks">
        {data.tasks.length ? (
          <s-stack direction="block" gap="base">
            {data.tasks.map((task) => (
              <s-box
                key={task.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-paragraph>
                  <s-text>{task.title}</s-text>
                  <s-text> · {task.status}</s-text>
                </s-paragraph>
              </s-box>
            ))}
          </s-stack>
        ) : (
          <s-paragraph>No tasks yet.</s-paragraph>
        )}
      </s-section>

      <s-section heading="Decisions">
        {data.decisions.length ? (
          <s-stack direction="block" gap="base">
            {data.decisions.map((decision) => (
              <s-box
                key={decision.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-paragraph>
                  <s-text>{decision.decisionType}</s-text>
                  <s-text> · {decision.status}</s-text>
                  {decision.reason && <s-text> · {decision.reason}</s-text>}
                </s-paragraph>
              </s-box>
            ))}
          </s-stack>
        ) : (
          <s-paragraph>No decisions yet.</s-paragraph>
        )}
      </s-section>

      <s-section heading="Comments">
        {data.comments.length ? (
          <s-stack direction="block" gap="base">
            {data.comments.map((comment) => (
              <s-box
                key={comment.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-paragraph>{comment.body}</s-paragraph>
              </s-box>
            ))}
          </s-stack>
        ) : (
          <s-paragraph>No comments yet.</s-paragraph>
        )}
      </s-section>

      <s-section heading="Ledger timeline">
        {data.events.length ? (
          <s-stack direction="block" gap="base">
            {data.events.map((event) => (
              <s-box
                key={event.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-paragraph>
                  <s-text>{event.title}</s-text>
                  <s-text> · {event.eventType}</s-text>
                  {event.message && <s-text> · {event.message}</s-text>}
                </s-paragraph>
              </s-box>
            ))}
          </s-stack>
        ) : (
          <s-paragraph>No ledger activity yet.</s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}
