interface IconProps {
	size?: number;
}

const svgProps = {
	fill: 'none',
	stroke: 'currentColor',
	strokeWidth: 2,
	strokeLinecap: 'round' as const,
	strokeLinejoin: 'round' as const,
	'aria-hidden': true,
};

export function ChevronLeftIcon({ size = 18 }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" {...svgProps}>
			<polyline points="15 18 9 12 15 6" />
		</svg>
	);
}

export function ChevronRightIcon({ size = 18 }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" {...svgProps}>
			<polyline points="9 18 15 12 9 6" />
		</svg>
	);
}

export function CloseIcon({ size = 18 }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" {...svgProps}>
			<line x1="18" y1="6" x2="6" y2="18" />
			<line x1="6" y1="6" x2="18" y2="18" />
		</svg>
	);
}
