interface Props<T extends string> {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  size?: 'sm' | 'md'
}

export function Segmented<T extends string>({ options, value, onChange, size = 'md' }: Props<T>) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 ${size === 'sm' ? 'py-0.5 text-[11.5px]' : 'py-1 text-[12px]'} transition-colors ${
            o.value === value ? 'bg-accent/10 font-medium text-accent' : 'text-sub hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
