#include "error.h"

#include <stdexcept>
#include <string>
#include <string_view>

namespace {

constexpr ErrorKind INVALID_INPUT{"invalid_input"};
constexpr ErrorKind MISSING{"missing"};
constexpr ErrorKind STATE_CONFLICT{"state_conflict"};
constexpr ErrorKind DEPENDENCY_UNAVAILABLE{"dependency_unavailable"};
constexpr ErrorKind UNAUTHORIZED{"unauthorized"};
constexpr ErrorKind NOT_FOUND{"not_found"};
constexpr ErrorKind CONFLICT{"conflict"};
constexpr ErrorKind TIMEOUT{"timeout"};
constexpr ErrorKind UNIMPLEMENTED{"unimplemented"};
constexpr ErrorKind ACCESS_DENIED{"access_denied"};

} // namespace

AppError::AppError(ErrorKind kind, std::string_view message, Retry retry)
    : std::runtime_error(std::string(message)), kind_(kind.name), retry_(retry) {}

AppError AppError::invalid_input(std::string_view message) { return {INVALID_INPUT, message}; }

AppError AppError::missing(std::string_view message) { return {MISSING, message}; }

AppError AppError::state_conflict(std::string_view message) { return {STATE_CONFLICT, message}; }

AppError AppError::dependency_unavailable(std::string_view message) {
  return {DEPENDENCY_UNAVAILABLE, message, Retry::Yes};
}

AppError AppError::unauthorized(std::string_view message) { return {UNAUTHORIZED, message}; }

AppError AppError::not_found(std::string_view message) { return {NOT_FOUND, message}; }

AppError AppError::conflict(std::string_view message) { return {CONFLICT, message}; }

AppError AppError::timeout(std::string_view message) { return {TIMEOUT, message, Retry::Yes}; }

AppError AppError::unimplemented(std::string_view message) { return {UNIMPLEMENTED, message}; }

AppError AppError::access_denied(std::string_view message) { return {ACCESS_DENIED, message}; }
