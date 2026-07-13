export default function Lightbox({ src, onClose }) {
  if (!src) return null;
  return (
    <div className="lightbox open" onClick={onClose}>
      <img src={src} alt="Screenshot" />
    </div>
  );
}
