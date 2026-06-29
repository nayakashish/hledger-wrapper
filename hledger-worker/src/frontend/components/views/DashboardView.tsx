interface Props {
	isActive: boolean;
}

export default function DashboardView({ isActive }: Props) {
	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-dashboard">
			<div className="state-msg">Dashboard coming soon.</div>
		</div>
	);
}
