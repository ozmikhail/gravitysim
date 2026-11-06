#ifndef GRAV_LIB_OPENMP_BARNES_HUT_H
#define GRAV_LIB_OPENMP_BARNES_HUT_H

namespace grav {

struct Particles;
struct SimParams;

void compute_barnes_hut(Particles& particles, const SimParams& params, float softening_sq);

} // namespace grav

#endif // GRAV_LIB_OPENMP_BARNES_HUT_H
