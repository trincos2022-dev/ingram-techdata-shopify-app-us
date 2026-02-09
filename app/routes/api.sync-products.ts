import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
  getLatestProductSyncJob,
  startProductSync,
} from "../services/product-sync.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const job = await getLatestProductSyncJob(session.shop);
  return Response.json({ job });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  try {
    const job = await startProductSync(session.shop);
    return Response.json({ ok: true, job });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start sync";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
};
