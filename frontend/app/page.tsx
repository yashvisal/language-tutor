import Link from "next/link"

export default function Page() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <nav className="flex flex-col gap-3 text-sm">
        <Link href="/session" className="underline-offset-4 hover:underline">
          Session
        </Link>
        <Link
          href="/design-inspo"
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Design exploration
        </Link>
      </nav>
    </div>
  )
}
