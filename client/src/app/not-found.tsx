import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-sm font-medium text-slate-500">404</p>
      <h1 className="text-2xl font-semibold text-slate-100">Page not found</h1>
      <Link href="/" className="text-sm text-accent underline underline-offset-4">
        Back home
      </Link>
    </div>
  );
}
