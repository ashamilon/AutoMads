import { PortalShell } from "@/components/shell";
import { RequireAuth } from "@/components/require-auth";
import { NavProgress } from "@/components/nav-progress";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <NavProgress />
      <PortalShell>{children}</PortalShell>
    </RequireAuth>
  );
}
