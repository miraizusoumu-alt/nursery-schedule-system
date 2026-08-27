export function nationalHolidayForDate(nationalHolidays, date) {
  return (nationalHolidays ?? []).find((holiday) => holiday.holidayDate === date) ?? null;
}

export function isNationalHoliday(nationalHolidays, date) {
  return nationalHolidayForDate(nationalHolidays, date) !== null;
}
