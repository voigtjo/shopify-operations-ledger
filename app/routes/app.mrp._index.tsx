import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";

import { PlanningEmptyState } from "../components/PlanningEmptyState";
import { requirePlanningContext } from "../lib/app-context.server";
import {
  createDemoKitBom,
  loadMrpRunList,
  runDemoKitMrpPreview,
} from "../lib/material-planning.server";
import { formatStatus, shortReference } from "../lib/ui-format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return { configured: false as const, runs: [] };
  }

  return {
    configured: true as const,
    runs: await loadMrpRunList(context.pool, context.ctx, { limit: 50 }),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const context = await requirePlanningContext(request);

  if (!context.configured) {
    return { ok: false, message: "Database is not configured." };
  }

  await createDemoKitBom(context.pool, context.ctx);
  const preview = await runDemoKitMrpPreview(context.pool, context.ctx, 1);

  return {
    ok: Boolean(preview),
    message: preview
      ? "Demo Kit MRP Preview has been run."
      : "Unable to run MRP Preview.",
  };
};

export default function MrpIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  return (
    <s-page heading="MRP Runs">
      <s-section heading="Planning previews">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            MRP runs are previews until you explicitly commit recommended needs.
          </s-paragraph>
          {actionData && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>{actionData.message}</s-paragraph>
            </s-box>
          )}
          <Form method="post">
            <s-button
              type="submit"
              variant="primary"
              disabled={!data.configured}
              {...(isSubmitting ? { loading: true } : {})}
            >
              Run Demo Kit MRP Preview
            </s-button>
          </Form>
          {!data.configured && (
            <PlanningEmptyState>
              Database connection is not configured.
            </PlanningEmptyState>
          )}
          {data.configured && data.runs.length === 0 && (
            <PlanningEmptyState>No MRP runs yet.</PlanningEmptyState>
          )}
          {data.runs.map((run) => (
            <s-box
              key={run.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-paragraph>
                <s-link href={`/app/mrp/${run.id}`}>
                  {run.runNumber || shortReference(run.id)}
                </s-link>
                <s-text> · {formatStatus(run.status)}</s-text>
                <s-text> · {run.lineCount} lines</s-text>
              </s-paragraph>
              <s-paragraph>
                <s-text>
                  {run.needsCommitted
                    ? `${run.committedCount} lines committed`
                    : "Needs not committed"}
                </s-text>
              </s-paragraph>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
