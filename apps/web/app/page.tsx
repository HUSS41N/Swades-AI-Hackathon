import { getWebEnv } from "@repo/env/web";

import {
  type HealthPayload,
  StudioClient,
} from "../components/studio-client";

async function fetchHealth(apiBase: string): Promise<HealthPayload | null> {
  const res = await fetch(`${apiBase}/health`, {
    next: { revalidate: 0 },
  }).catch(() => null);

  if (!res?.ok) {
    return null;
  }

  return (await res.json()) as HealthPayload;
}

export default async function HomePage() {
  const env = getWebEnv(process.env);
  const health = await fetchHealth(env.NEXT_PUBLIC_API_URL);

  return (
    <StudioClient
      apiBaseUrl={env.NEXT_PUBLIC_API_URL}
      initialHealth={health}
    />
  );
}
