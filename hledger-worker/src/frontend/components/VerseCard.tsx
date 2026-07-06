import { useState } from 'react';
import { verses } from '../../data/verses';

export default function VerseCard() {
	const [sessionIdx, setSessionIdx] = useState<number | null>(null);

	if (verses.length === 0) return null;

	const now = new Date();
	const dayOfYear = Math.floor(
		(now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000
	);
	const dailyIdx = dayOfYear % verses.length;
	const verse = verses[sessionIdx ?? dailyIdx];

	const cycle = () => setSessionIdx(Math.floor(Math.random() * verses.length));

	return (
		<div className="dash-chart-card verse-card">
			{verses.length > 1 && (
				<button className="verse-cycle-btn" onClick={cycle} aria-label="Next verse">
					↻
				</button>
			)}
			<p className="verse-text">{verse.text}</p>
			<p className="verse-ref">{verse.reference}</p>
		</div>
	);
}
