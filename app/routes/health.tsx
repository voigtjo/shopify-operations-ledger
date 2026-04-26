import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return Response.json({
    ok: true,
    service: "operations-ledger",
    path: new URL(request.url).pathname,
  });
};
