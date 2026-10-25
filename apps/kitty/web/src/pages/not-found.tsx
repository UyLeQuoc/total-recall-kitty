import { Link } from "react-router";

export function NotFound() {
  return (
    <div className="space-y-2 py-10 text-center">
      <h1 className="text-2xl font-bold">Nothing here</h1>
      <Link className="text-brand-700 underline" to="/">
        Back to the pots
      </Link>
    </div>
  );
}
