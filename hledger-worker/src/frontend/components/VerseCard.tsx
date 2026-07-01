import { useState } from 'react';
import { verses } from '../../data/verses';

export default function VerseCard() {
	const [sessionIdx, setSessionIdx] = useState<number | null>(null);

	if (verses.length === 0) return null;

	const monthlyIdx = new Date().getMonth() % verses.length;
	const verse = verses[sessionIdx ?? monthlyIdx];

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
