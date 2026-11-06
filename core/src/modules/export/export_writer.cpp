#include "modules/export/export_writer.h"

#include "error.h"
#include "modules/sim/particles.h"

#include <cmath>
#include <cstddef>
#include <filesystem>
#include <iomanip>
#include <ios>
#include <limits>
#include <locale>
#include <ostream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace grav {

namespace {

constexpr int FRAME_NUMBER_WIDTH = 6;
constexpr std::size_t RGB_CHANNELS = 3;

void write_number(std::ostream& out, double value) {
  if (std::isfinite(value)) {
    out << value;
  } else {
    out << "null";
  }
}

AppError write_error(const std::filesystem::path& path) {
  return AppError::dependency_unavailable("export: could not write " + path.string());
}

} // namespace

ExportWriter::ExportWriter(ExportPaths paths)
    : positions_path_(std::move(paths.positions)), frames_(std::move(paths.frames)) {
  if (!positions_path_.empty() && std::filesystem::exists(positions_path_)) {
    throw AppError::conflict("export: position stream already exists: " + positions_path_.string());
  }
  if (writes_frames() && !std::filesystem::create_directories(frames_)) {
    throw AppError::conflict("export: frame directory already exists: " + frames_.string());
  }
  if (!positions_path_.empty()) {
    if (positions_path_.has_parent_path()) {
      std::filesystem::create_directories(positions_path_.parent_path());
    }
    positions_.open(positions_path_, std::ios::binary);
    if (!positions_) {
      throw write_error(positions_path_);
    }
    positions_.imbue(std::locale::classic());
    positions_ << std::setprecision(std::numeric_limits<double>::max_digits10);
  }
}

void ExportWriter::write_positions(const FrameSample& sample, const Particles& particles) {
  positions_ << "{\"frame\":" << sample.frame << ",\"run\":" << sample.run
             << ",\"step\":" << sample.step << ",\"time\":";
  write_number(positions_, sample.time);
  positions_ << ",\"positions\":[";
  for (std::size_t i = 0; i < count_particles(particles); ++i) {
    if (i != 0) {
      positions_ << ',';
    }
    const auto pos = particles.positions.at(i);
    positions_ << '[' << id_of(particles, i) << ',';
    write_number(positions_, pos.x);
    positions_ << ',';
    write_number(positions_, pos.y);
    positions_ << ',';
    write_number(positions_, pos.z);
    positions_ << ']';
  }
  positions_ << "]}\n" << std::flush;
  if (!positions_) {
    throw write_error(positions_path_);
  }
}

void ExportWriter::write_frame(const FrameSample& sample, int width, int height,
                               const std::vector<unsigned char>& rgb) {
  std::ostringstream name;
  name.imbue(std::locale::classic());
  name << "frame-" << std::setfill('0') << std::setw(FRAME_NUMBER_WIDTH) << sample.frame << ".ppm";
  const auto path = frames_ / name.str();
  std::ofstream out(path, std::ios::binary);
  out.imbue(std::locale::classic());
  out << "P6\n" << width << ' ' << height << "\n255\n";
  const auto row_bytes = static_cast<std::size_t>(width) * RGB_CHANNELS;
  for (int row = height - 1; row >= 0; --row) {
    const auto row_offset = static_cast<std::ptrdiff_t>(static_cast<std::size_t>(row) * row_bytes);
    const auto row_begin = rgb.begin() + row_offset;
    const std::string bytes(row_begin, row_begin + static_cast<std::ptrdiff_t>(row_bytes));
    out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
  }
  out.close();
  if (!out) {
    throw write_error(path);
  }
}

} // namespace grav
