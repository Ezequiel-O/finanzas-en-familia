// src/components/ui/card.jsx

export function Card({ children, className = '' }) {
  return (
    <div
      className={`rounded-2xl shadow-sm dark:shadow-none border p-4 bg-white dark:bg-gray-800 ${className}`}
    >
      {children}
    </div>
  );
}
