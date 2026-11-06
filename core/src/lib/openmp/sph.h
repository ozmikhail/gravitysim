#ifndef GRAV_LIB_OPENMP_SPH_H
#define GRAV_LIB_OPENMP_SPH_H

namespace grav {

struct Particles;
struct SimParams;

void compute_sph(Particles& particles, const SimParams& params);
void confine_fluid(Particles& particles);

} // namespace grav

#endif // GRAV_LIB_OPENMP_SPH_H
