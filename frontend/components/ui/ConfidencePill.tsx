interface ConfidencePillProps {
  score: number; // 0.0 – 1.0
}

export default function ConfidencePill({ score }: ConfidencePillProps) {
  let className: string;
  if (score >= 0.85) {
    className = "bg-green-100 text-green-800";
  } else if (score >= 0.7) {
    className = "bg-amber-100 text-amber-800";
  } else {
    className = "bg-red-100 text-red-800";
  }

  return (
    <span
      className={`inline-flex items-center rounded px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      {Math.round(score * 100)}%
    </span>
  );
}
