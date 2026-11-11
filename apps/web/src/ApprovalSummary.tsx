import { approvalSummaryText, type ApprovalState } from './approvalText';

export default function ApprovalSummary({
  creative,
}: {
  creative: ApprovalState;
}) {
  const text = approvalSummaryText(creative);
  return text ? <span className="approval-summary">{text}</span> : null;
}
