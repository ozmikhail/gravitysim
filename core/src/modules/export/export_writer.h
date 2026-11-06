#ifndef GRAV_MODULES_EXPORT_EXPORT_WRITER_H
#define GRAV_MODULES_EXPORT_EXPORT_WRITER_H

#include <cstddef>
#include <filesystem>
#include <fstream>
#include <vector>

namespace grav {

struct Particles;

struct FrameSample {
  std::size_t frame = 0;
  std::size_t run = 0;
  std::size_t step = 0;
  double time = 0.0;
};

struct ExportPaths {
  std::filesystem::path positions;
  std::filesystem::path frames;
};

class ExportWriter {
public:
  explicit ExportWriter(ExportPaths paths);

  [[nodiscard]] bool writes_positions() const { return positions_.is_open(); }
  [[nodiscard]] bool writes_frames() const { return !frames_.empty(); }

  void write_positions(const FrameSample& sample, const Particles& particles);
  void write_frame(const FrameSample& sample, int width, int height,
                   const std::vector<unsigned char>& rgb);

private:
  std::filesystem::path positions_path_;
  std::filesystem::path frames_;
  std::ofstream positions_;
};

} // namespace grav

#endif // GRAV_MODULES_EXPORT_EXPORT_WRITER_H
