import { statusLabel, statusTone } from './statusDisplay';

// The label carries the meaning; the tone color only reinforces it.
export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge badge-${statusTone(status)}`}>
      {statusLabel(status)}
    </span>
  );
}
