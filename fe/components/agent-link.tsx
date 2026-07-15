import Link from "next/link";

export function AgentLink({
  agentId,
  name,
  handle,
  className = "",
}: {
  agentId: string | null;
  name: string | null;
  handle?: string | null;
  className?: string;
}) {
  if (!agentId) return <span className="text-ink3">unknown</span>;
  return (
    <Link
      href={`/agents/${agentId}`}
      className={`text-ink underline-offset-2 hover:text-accent hover:underline ${className}`}
    >
      {name || agentId.slice(-8)}
      {handle && <span className="ml-1.5 text-xs text-ink3">@{handle}</span>}
    </Link>
  );
}
