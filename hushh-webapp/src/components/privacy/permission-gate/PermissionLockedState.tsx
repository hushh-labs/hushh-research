import { PermissionRule } from "./permissionRules";

interface Props {
  rule: PermissionRule;
}

export default function PermissionLockedState({ rule }: Props) {
  return (
    <div
      data-testid="permission-locked-state"
      className="rounded-xl border border-slate-200 bg-slate-50 p-5"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Privacy Guard
      </p>

      <h3 className="mt-2 text-base font-semibold text-slate-900">
        Consent required to access this feature
      </h3>

      <p className="mt-2 text-sm text-slate-600">{rule.description}</p>

      <button
        type="button"
        className="mt-4 rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white"
      >
        Review permissions
      </button>
    </div>
  );
}