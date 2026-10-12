import { createServerFn } from "@tanstack/react-start";
import { queryOptions } from "@tanstack/react-query";
import type { ProfileResult } from "./product-profile";

// Public read: returns only the allowlisted profile built in product-profile.ts.
export const getProductProfile = createServerFn({ method: "GET" })
  .inputValidator((d: { slug: string }) => ({ slug: String(d?.slug ?? "").slice(0, 80) }))
  .handler(async ({ data }): Promise<ProfileResult> => {
    const { loadProfile } = await import("./product-profile");
    const { productionProfileDeps } = await import("./product-profile.server");
    return loadProfile(productionProfileDeps, data.slug);
  });

export const productProfileQuery = (slug: string) =>
  queryOptions({
    queryKey: ["product-profile", slug],
    queryFn: () => getProductProfile({ data: { slug } }),
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
