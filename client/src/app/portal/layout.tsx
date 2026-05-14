import { PortalShell } from "@/components/shell";
import { RequireAuth } from "@/components/require-auth";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <PortalShell>{children}</PortalShell>
    </RequireAuth>
  );
}
