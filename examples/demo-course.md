---
course: Demo — Calculus & Physics
source: Exam Assistant demo
tags: demo
---
# Chapter 1 · Limits & derivatives

## Part I · Single choice
1. What is $\displaystyle\lim_{x\to 0}\frac{\sin x}{x}$?
A. $0$
B. $1$
C. $\infty$
D. does not exist
Answer: B
Explanation: The standard limit; it follows from the squeeze theorem with $\cos x \le \frac{\sin x}{x} \le 1$.
Difficulty: 1

2. The derivative of $f(x)=e^{2x}$ is
A. $e^{2x}$  B. $2e^{2x}$  C. $2xe^{2x-1}$  D. $\frac{1}{2}e^{2x}$
Answer: B
Explanation: Chain rule: $\frac{d}{dx}e^{u} = e^{u}u'$ with $u=2x$.

## Part II · Multiple choice
3. Which of the following functions are continuous on all of $\mathbb{R}$?
A. $|x|$
B. $\frac{1}{x}$
C. $\sin x$
D. $\lfloor x \rfloor$
Answer: AC
Explanation: $\frac1x$ is undefined at $0$; the floor function jumps at every integer.

## Part III · True / False
4. Every differentiable function is continuous.
Answer: True
Explanation: Differentiability at a point implies continuity there. The converse is false (e.g. $|x|$ at $0$).

5. If $f'(c)=0$ then $f$ has a local extremum at $c$.
Answer: False
Explanation: Counterexample: $f(x)=x^3$ at $c=0$.

## Part IV · Fill in the blank
6. The derivative of $\ln x$ is ____ and the derivative of $\cos x$ is ____.
Answer: 1/x | \frac{1}{x}; -sin x | -sinx | −sin x
Explanation: $(\ln x)' = \frac1x$, $(\cos x)' = -\sin x$.

7. $\int_0^{\pi} \sin x\,dx =$ {{2}}

## Part V · Calculation
8. Compute $\displaystyle\int_0^1 (3x^2 + 2x)\,dx$.
Answer: 2
Explanation: $\left[x^3 + x^2\right]_0^1 = 1 + 1 = 2$.

9. Find the slope of the tangent to $y = x^3 - 2x$ at $x=2$, and the $y$-intercept of that tangent line.
Answer: slope = 10; intercept = -16
Explanation: $y' = 3x^2 - 2 = 10$ at $x=2$; the point is $(2, 4)$, so $y = 10x - 16$.

## Part VI · Short answer
10. State the Mean Value Theorem and give its geometric meaning.
Answer: If $f$ is continuous on $[a,b]$ and differentiable on $(a,b)$, there is $c\in(a,b)$ with $f'(c)=\dfrac{f(b)-f(a)}{b-a}$. Geometrically: some tangent line is parallel to the secant through $(a,f(a))$ and $(b,f(b))$.
Keywords: continuous, differentiable, tangent, secant

# Chapter 2 · Mechanics

## Single choice
11. A $2\,\text{kg}$ block rests on a frictionless incline (see figure). What is the component of gravity along the incline? ($g = 9.8\ \text{m/s}^2$)
![[incline.svg]]
A. $9.8\ \text{N}$  B. $16.97\ \text{N}$  C. $19.6\ \text{N}$  D. $4.9\ \text{N}$
Answer: A
Explanation: $F_\parallel = mg\sin\theta = 2 \times 9.8 \times \sin 30^\circ = 9.8\ \text{N}$.

## Calculation
12. A car starts from rest and accelerates uniformly at $2.5\ \text{m/s}^2$ for $8\ \text{s}$. How far does it travel?
Answer: 80 m
Explanation: $s = \tfrac12 a t^2 = \tfrac12 \cdot 2.5 \cdot 64 = 80\ \text{m}$.

13. A ball is thrown straight up at $15\ \text{m/s}$. Find its maximum height ($g = 9.8\ \text{m/s}^2$).
Answer: 11.48 m ± 0.05
Explanation: $h = \dfrac{v^2}{2g} = \dfrac{225}{19.6} \approx 11.48\ \text{m}$.

## True / False
14. In the absence of air resistance, a heavier object falls faster than a lighter one.
Answer: 错
Explanation: All objects fall with the same acceleration $g$ (Galileo).

## Fill in the blank
15. Newton's second law: $\vec F =$ ____ ; the SI unit of force is the ____.
Answer: ma | m*a | m a; newton | N | Newton

## Short answer
16. Explain the difference between speed and velocity.
Answer: Speed is a scalar — how fast something moves (magnitude only). Velocity is a vector — the rate of change of position, with both magnitude and direction.
Keywords: scalar, vector, direction
