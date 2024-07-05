import React, { useState } from "react";
import "./Dropdown.css";

const colors = [
  { value: "red", label: "Red" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
  { value: "yellow", label: "Yellow" },
  { value: "purple", label: "Purple" },
  { value: "gray", label: "Gray" },
  { value: "black", label: "Black" },
  { value: "pink", label: "Pink" },
];

export function Dropdown() {
  const [selectedColor, setSelectedColor] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const handleOptionClick = (color: string) => {
    setSelectedColor(color);
    setDropdownOpen(false);
  };

  return (
    <div className="dropdown">
      <div
        className="dropdown-selected"
        onClick={() => setDropdownOpen(!dropdownOpen)}
      >
        {selectedColor
          ? colors.find((color) => color.value === selectedColor)?.label
          : "Select a color"}
      </div>
      {dropdownOpen && (
        <div className="dropdown-options">
          {colors.map((color) => (
            <div
              key={color.value}
              className="color-option"
              onClick={() => handleOptionClick(color.value)}
            >
              <p>{color.label}</p>
              <div className={`color-ball ${color.value}`}></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
