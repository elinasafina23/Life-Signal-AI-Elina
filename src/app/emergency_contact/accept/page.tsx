// app/emergency_contact/accept/page.tsx
import { redirect } from "next/navigation";

const SAFE_NEXT_PREFIX = "/";

function buildSignupSearch(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  search.set("role", "emergency_contact");

  const token = params.token?.trim();
  if (token) search.set("token", token);

  const invite = params.invite?.trim();
  if (invite) search.set("invite", invite);

  const next = params.next?.trim();
  if (next && next.startsWith(SAFE_NEXT_PREFIX)) {
    search.set("next", next === "/" ? "" : next);
  }

  return search.toString();
}

export default function EmergencyContactAcceptRedirect({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const normalized: Record<string, string | undefined> = {};
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (Array.isArray(value)) {
        normalized[key] = value[0];
      } else {
        normalized[key] = value;
      }
    }
  }

  const qs = buildSignupSearch(normalized);
  const destination = qs ? `/signup?${qs}` : "/signup?role=emergency_contact";
  redirect(destination);
}
