import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";

import { NextActionCard, StatusBadge, SummaryCard } from "../components/OperationsUi";
import { requirePlanningContext } from "../lib/app-context.server";
import {
  commitMrpRunNeeds,
  loadMrpRunDetail,
} from "../lib/material-planning.server";
import {
  formatAction,
  formatQuantity,
  formatStatus,
  shortReference,
} from "../lib/ui-format";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return { configured: false as const, run: null };
  }

  return {
    configured: true as const,
    run: await loadMrpRunDetail(context.pool, context.ctx, params.id!),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return { ok: false, message: "Database is not configured." };
  }

  const result = await commitMrpRunNeeds(context.pool, context.ctx, {
    mrpRunId: params.id!,
  });

  return {
    ok: true,
    message: `Committed ${result.purchaseNeeds.length} purchase need(s) and ${result.productionNeeds.length} production need(s).`,
  };
};

export default function MrpDetail() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  if (!data.configured || !data.run) {
    return (
      <s-page heading="MRP run">
        <s-section heading="Connection">
          <s-paragraph>Database connection is not configured.</s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const run = data.run;
  const committedCount = run.lines.filter((line) => line.committed).length;
  const canCommit =
    run.status === "completed" &&
    run.lines.some(
      (line) =>
        !line.committed &&
        line.shortageQuantity > 0 &&
        ["purchase", "produce"].includes(line.recommendedAction),
    );

  return (
    <s-page heading={`MRP Run · ${run.runNumber}`}>
      <s-section heading="Run summary">
        <s-stack direction="block" gap="base">
          {actionData && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>{actionData.message}</s-paragraph>
            </s-box>
          )}
          <SummaryCard heading="MRP Preview Status">
            <s-paragraph>
              <StatusBadge status={run.status} />{" "}
              <StatusBadge
                status={committedCount > 0 ? "needs_committed" : "preview_only"}
              />
            </s-paragraph>
            <s-paragraph>
              Source: {formatStatus(run.demandSourceType)} -{" "}
              {shortReference(run.demandSourceId)}
            </s-paragraph>
            <s-paragraph>
              {committedCount > 0
                ? `${committedCount} line(s) already committed`
                : "No purchase or production needs have been created from this preview."}
            </s-paragraph>
            <s-link href="/app/mrp">Back to MRP runs</s-link>
          </SummaryCard>
          {canCommit ? (
            <NextActionCard
              title="Commit operational needs"
              href="/app/needs"
              actionLabel="Open Needs after commit"
            >
              Commit this preview to create purchase and production needs from
              shortage lines. Preview lines with no shortage stay informational.
            </NextActionCard>
          ) : (
            <NextActionCard
              title="Review committed work"
              href="/app/needs"
              actionLabel="Open Needs"
            >
              This run has no remaining shortage lines available to commit.
            </NextActionCard>
          )}
          <Form method="post">
            <s-button
              type="submit"
              variant="primary"
              disabled={!canCommit}
              {...(isSubmitting ? { loading: true } : {})}
            >
              Commit Needs from Preview
            </s-button>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="Run lines">
        <s-stack direction="block" gap="base">
          {run.lines.map((line) => (
            <s-box
              key={line.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-paragraph>
                <s-link href={`/app/items/${line.itemId}`}>
                  {line.sku ?? line.itemId}
                </s-link>
                <s-text> - {formatAction(line.recommendedAction)}</s-text>
                <s-text>
                  {" "}
                  - {line.committed ? "Already committed" : "Not committed"}
                </s-text>
              </s-paragraph>
              <s-paragraph>
                Required {formatQuantity(line.requiredQuantity)} - Available{" "}
                {formatQuantity(line.availableQuantity)} - Shortage{" "}
                {formatQuantity(line.shortageQuantity)}
              </s-paragraph>
              <s-paragraph>{line.explanation}</s-paragraph>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
