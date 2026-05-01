import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";

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
          <s-paragraph>Status: {formatStatus(run.status)}</s-paragraph>
          <s-paragraph>
            Source: {formatStatus(run.demandSourceType)} ·{" "}
            {shortReference(run.demandSourceId)}
          </s-paragraph>
          <s-paragraph>
            {committedCount > 0
              ? `${committedCount} line(s) already committed`
              : "No needs committed yet"}
          </s-paragraph>
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
                <s-text> · {formatAction(line.recommendedAction)}</s-text>
                <s-text>
                  {" "}
                  · {line.committed ? "Already committed" : "Not committed"}
                </s-text>
              </s-paragraph>
              <s-paragraph>
                Required {formatQuantity(line.requiredQuantity)} · Available{" "}
                {formatQuantity(line.availableQuantity)} · Shortage{" "}
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
