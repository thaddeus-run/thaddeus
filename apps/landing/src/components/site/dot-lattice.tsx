import { useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useRef } from 'react';

import { cn } from '@/lib/cn';

export type LatticeShape = 'lattice' | 'sphere';

interface Point3 {
  x: number;
  y: number;
  z: number;
}

// Points for each shape, in a unit-ish space about 5 units across.
function buildPoints(shape: LatticeShape): Point3[] {
  if (shape === 'sphere') {
    // Fibonacci sphere: evenly spread points with no visible seams.
    const n = 520;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const radius = 2.6;
    return Array.from({ length: n }, (_, i) => {
      const y = 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const angle = golden * i;
      return {
        x: Math.cos(angle) * r * radius,
        y: y * radius,
        z: Math.sin(angle) * r * radius,
      };
    });
  }
  const n = 6;
  const points: Point3[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      for (let k = 0; k < n; k += 1) {
        points.push({ x: i - 2.5, y: j - 2.5, z: k - 2.5 });
      }
    }
  }
  return points;
}

// The twelve edges of the lattice's bounding cube, drawn as hairlines.
const cubeCorners: Point3[] = [-2.5, 2.5].flatMap((x) =>
  [-2.5, 2.5].flatMap((y) => [-2.5, 2.5].map((z) => ({ x, y, z })))
);
const cubeEdges: Array<[number, number]> = [];
for (let a = 0; a < 8; a += 1) {
  for (let b = a + 1; b < 8; b += 1) {
    const pa = cubeCorners[a];
    const pb = cubeCorners[b];
    if (pa === undefined || pb === undefined) continue;
    const differs =
      Number(pa.x !== pb.x) + Number(pa.y !== pb.y) + Number(pa.z !== pb.z);
    if (differs === 1) cubeEdges.push([a, b]);
  }
}

function rotate(p: Point3, yaw: number, pitch: number): Point3 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = p.x * cy - p.z * sy;
  const z1 = p.x * sy + p.z * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return { x: x1, y: p.y * cp - z1 * sp, z: p.y * sp + z1 * cp };
}

// A slow-turning cloud of points drawn on a canvas in the page's ink colour.
// Abstract on purpose: it is the first thing that moves, not a diagram.
// Pauses while off screen and holds a single frame under reduced motion.
export function DotLattice({
  shape = 'lattice',
  className,
}: {
  shape?: LatticeShape;
  className?: string;
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion() === true;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return undefined;

    const points = buildPoints(shape);
    let width = 0;
    let height = 0;
    let frame = 0;
    let raf = 0;
    let visible = true;
    let ink = '#17171a';

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const readInk = (): void => {
      const value = getComputedStyle(canvas).getPropertyValue('--ink').trim();
      if (value !== '') ink = value;
    };

    const draw = (t: number): void => {
      const yaw = 0.6 + t * 0.0022;
      const pitch = 0.45 + Math.sin(t * 0.0012) * 0.25;
      const scale = Math.min(width, height) * 0.085;
      const depth = 9;
      const cx = width / 2;
      const cy = height / 2;
      const project = (p: Point3): { x: number; y: number; f: number } => {
        const r = rotate(p, yaw, pitch);
        const f = depth / (depth + r.z);
        return { x: cx + r.x * f * scale, y: cy + r.y * f * scale, f };
      };

      ctx.clearRect(0, 0, width, height);

      if (shape === 'lattice') {
        ctx.strokeStyle = ink;
        ctx.globalAlpha = 0.16;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const [a, b] of cubeEdges) {
          const pa = cubeCorners[a];
          const pb = cubeCorners[b];
          if (pa === undefined || pb === undefined) continue;
          const qa = project(pa);
          const qb = project(pb);
          ctx.moveTo(qa.x, qa.y);
          ctx.lineTo(qb.x, qb.y);
        }
        ctx.stroke();
      }

      const projected = points.map(project).sort((a, b) => a.f - b.f);
      ctx.fillStyle = ink;
      for (const q of projected) {
        // f runs roughly 0.72 (far) to 1.4 (near); map that to alpha and size.
        const near = Math.min(1, Math.max(0, (q.f - 0.72) / 0.68));
        ctx.globalAlpha = 0.22 + 0.78 * near;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 1.1 + 1.5 * near, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const loop = (): void => {
      if (visible) {
        frame += 1;
        if (frame % 30 === 0) readInk();
        draw(frame);
      }
      raf = requestAnimationFrame(loop);
    };

    resize();
    readInk();
    const ro = new ResizeObserver(() => {
      resize();
      draw(frame);
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    io.observe(canvas);

    if (reduced) {
      draw(400);
    } else {
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, [shape, reduced]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn('block h-full w-full', className)}
    />
  );
}
